"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import Link from "next/link";
import useSWR from "swr";
import TempChart from "@/components/TempChart";
import PriceChart, { type BracketHistory } from "@/components/PriceChart";
import type { EnrichedTick } from "@/lib/weather-transform";
import { fallbackBracketLabel } from "@/lib/weather-transform";
import { useWeatherStream } from "@/lib/useWeatherStream";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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
    // Backstop only — the real trigger is the SSE stream below. Covers the
    // rare case a stream event gets dropped.
    refreshInterval: isToday ? 5 * 60_000 : 0,
  });

  // City-level stats (avg ticks/day + full dates list) — static, no refresh needed.
  const { data: cityStats } = useSWR<CityStats>(
    `/api/dates/${encodeURIComponent(cityDecoded)}`,
    fetcher,
    { revalidateOnFocus: false }
  );

  // Polymarket price histories — loaded after tick data arrives so we have
  // city + date confirmed. Refreshes every 5 min for today; static for past.
  const { data: priceHistoryData } = useSWR<PriceHistoryResponse>(
    data
      ? `/api/prices-history/${encodeURIComponent(cityDecoded)}/${params.date}`
      : null,
    fetcher,
    { refreshInterval: isToday ? 5 * 60_000 : 0, revalidateOnFocus: false }
  );

  // Refetch the instant a new tick for this exact city/date lands, instead
  // of waiting for the next poll.
  useWeatherStream((evt) => {
    if (isToday && evt.city === cityDecoded.toLowerCase() && evt.local_date === params.date) {
      mutate();
    }
  });

  // ── Date picker ────────────────────────────────────────────────────────────
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLAnchorElement>(null);

  // Close when clicking outside the picker
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

  // Scroll the active date into view when the picker opens
  useEffect(() => {
    if (pickerOpen && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [pickerOpen]);

  // ── Window stats ───────────────────────────────────────────────────────────
  const windowStats = useMemo(() => {
    if (!data?.ticks?.length) return null;

    // Anchor to the latest paced_at in the dataset, not Date.now().
    // Works the same whether it's today's live-streaming data or a past static day.
    const anchor = Math.max(
      ...data.ticks.map(t => t.paced_at ?? 0),
      ...(data.reciprocalTicks ?? []).map(t => t.paced_at ?? 0)
    );

    const windows = [
      { label: "1h", ms: 60 * 60_000 },
      { label: "2h", ms: 2 * 60 * 60_000 },
      { label: "4h", ms: 4 * 60 * 60_000 },
    ];

    return windows.map(({ label, ms }) => {
      const cutoff = anchor - ms;
      const linear = data.ticks.filter(t => (t.paced_at ?? 0) >= cutoff);
      const reciprocal = (data.reciprocalTicks ?? []).filter(t => (t.paced_at ?? 0) >= cutoff);

      const linearAvg = avg(linear.map(t => t.weighted_avg));
      const reciprocalAvg = avg(reciprocal.map(t => t.weighted_avg));

      // Derive brackets independently from each collection's window average.
      const linearBracket =
        linearAvg != null ? fallbackBracketLabel(linearAvg, data.unit) : null;
      const recBracket =
        reciprocalAvg != null ? fallbackBracketLabel(reciprocalAvg, data.unit) : null;

      // Yes price: most recent tick whose bracket matches the collection's
      // window bracket — so each price reflects the actual contract it refers to.
      const matchingLinearTick = [...linear].reverse().find(
        t => t.point_bracket === linearBracket
      );
      const lastYesPriceLinear = matchingLinearTick?.yes_price ?? linear.at(-1)?.yes_price ?? null;

      const matchingRecTick = [...reciprocal].reverse().find(
        t => t.point_bracket === recBracket
      );
      const lastYesPriceRec = matchingRecTick?.yes_price ?? reciprocal.at(-1)?.yes_price ?? null;

      return {
        label,
        linearAvg,
        linearBracket,
        lastYesPriceLinear,
        reciprocalAvg,
        recBracket,
        lastYesPriceRec,
        tickCount: linear.length
      };
    });
  }, [data?.ticks, data?.reciprocalTicks]);

  return (
    <div>
      <div className="text-subtext text-sm mb-2">
        <Link href="/">Regions</Link> /{" "}
        <Link href={`/${params.region}`} className="capitalize">
          {params.region}
        </Link>{" "}
        /{" "}
        <Link href={`/${params.region}/${encodeURIComponent(cityDecoded)}`} className="capitalize">
          {cityDecoded}
        </Link>{" "}
        / {params.date}
      </div>

      <h1 className="text-xl font-semibold mb-1 capitalize flex items-center gap-2 flex-wrap">
        {cityDecoded} —{" "}

        {/* Clickable date with dropdown picker */}
        <span className="relative" ref={pickerRef}>
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="text-price underline decoration-dotted underline-offset-2 cursor-pointer hover:opacity-75 transition-opacity"
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
          >
            {params.date}
          </button>

          {pickerOpen && (
            <div
              role="listbox"
              className="absolute left-0 top-full mt-1 z-50 min-w-[9rem] max-h-64 overflow-y-auto rounded-lg border border-border bg-panel shadow-2xl"
            >
              {(cityStats?.dates ?? []).length === 0 && (
                <div className="px-3 py-2 text-sm text-subtext">No dates</div>
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
                        ? "text-price font-semibold bg-[#1a2030]"
                        : "text-text hover:bg-[#1e2229]",
                    ].join(" ")}
                  >
                    {d}
                  </Link>
                );
              })}
            </div>
          )}
        </span>

        {isToday && (
          <span className="text-live text-sm font-normal">● Updating Live</span>
        )}
      </h1>

      {cityStats?.avgTicksPerDay != null && (
        <div className="text-sm text-subtext mb-4">
          avg{" "}
          <span className="text-price font-medium">{cityStats.avgTicksPerDay.toFixed(1)}</span>
          {" "}ticks/day
          <span className="ml-1 opacity-50">({cityStats.totalDays}d)</span>
        </div>
      )}

      {isLoading && <div className="text-subtext mt-4">Loading…</div>}
      {data && data.ticks.length === 0 && (
        <div className="text-subtext mt-4">No ticks recorded for this city/date.</div>
      )}

      {data && data.ticks.length > 0 && (
        <div className="mt-6 space-y-8 max-w-7xl">
          <section>
            <h2 className="text-sm text-subtext mb-2">Forecast temp over the day</h2>
            <TempChart
              ticks={data.ticks}
              reciprocalTicks={data.reciprocalTicks ?? []}
              unit={data.unit}
              winningLow={data.winningLow}
              winningHigh={data.winningHigh}
              winningBracket={data.winningBracket}
              windowStats={windowStats ?? undefined}
            />
          </section>
          <section>
            <h2 className="text-sm text-subtext mb-2">Market price over the day</h2>
            <PriceChart
              ticks={data.ticks}
              bracketHistories={priceHistoryData?.brackets ?? []}
              tzOffsetMs={priceHistoryData?.tzOffsetMs ?? 0}
            />
          </section>
        </div>
      )}
    </div>
  );
}
