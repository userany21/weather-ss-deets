"use client";

import { useMemo } from "react";
import Link from "next/link";
import useSWR from "swr";
import TempChart from "@/components/TempChart";
import PriceChart, { type BracketHistory } from "@/components/PriceChart";
import type { EnrichedTick } from "@/lib/weather-transform";
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

      return {
        label,
        linearAvg: avg(linear.map(t => t.weighted_avg)),
        reciprocalAvg: avg(reciprocal.map(t => t.weighted_avg)),
        lastYesPrice: linear.at(-1)?.yes_price ?? null,
        tickCount: linear.length,
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
      <h1 className="text-xl font-semibold mb-1 capitalize">
        {cityDecoded} — {params.date}
        {isToday && <span className="ml-2 text-live text-sm align-middle">● updating live</span>}
      </h1>

      {isLoading && <div className="text-subtext mt-4">Loading…</div>}
      {data && data.ticks.length === 0 && (
        <div className="text-subtext mt-4">No ticks recorded for this city/date.</div>
      )}

      {data && data.ticks.length > 0 && (
        <div className="mt-6 space-y-8 max-w-4xl">
          <section>
            <h2 className="text-sm text-subtext mb-2">Forecast temp over the day</h2>
            <TempChart
              ticks={data.ticks}
              reciprocalTicks={data.reciprocalTicks ?? []}
              unit={data.unit}
              winningLow={data.winningLow}
              winningHigh={data.winningHigh}
              winningBracket={data.winningBracket}
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

          {windowStats && (
            <section>
              <h2 className="text-sm text-subtext mb-2">Rolling window averages</h2>
              <table className="text-sm w-full border-collapse">
                <thead>
                  <tr className="text-left text-subtext border-b border-border">
                    <th className="py-1 pr-4">Window</th>
                    <th className="py-1 pr-4">Linear avg</th>
                    <th className="py-1 pr-4">Reciprocal avg</th>
                    <th className="py-1 pr-4">Last yes price</th>
                    <th className="py-1">Ticks</th>
                  </tr>
                </thead>
                <tbody>
                  {windowStats.map((row) => (
                    <tr key={row.label} className="border-b border-border/50">
                      <td className="py-1 pr-4 font-mono">{row.label}</td>
                      <td className="py-1 pr-4">{row.linearAvg != null ? row.linearAvg.toFixed(3) : "—"}</td>
                      <td className="py-1 pr-4">{row.reciprocalAvg != null ? row.reciprocalAvg.toFixed(3) : "—"}</td>
                      <td className="py-1 pr-4">{row.lastYesPrice != null ? row.lastYesPrice.toFixed(3) : "—"}</td>
                      <td className="py-1">{row.tickCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
