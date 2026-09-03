"use client";

import Link from "next/link";
import useSWR from "swr";
import TempChart from "@/components/TempChart";
import PriceChart from "@/components/PriceChart";
import type { EnrichedTick } from "@/lib/weather-transform";
import { useWeatherStream } from "@/lib/useWeatherStream";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface DayResponse {
  city: string;
  date: string;
  unit: "F" | "C";
  winningLow: number | null;
  winningHigh: number | null;
  winningBracket: string | null;
  ticks: EnrichedTick[];
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

  // Refetch the instant a new tick for this exact city/date lands, instead
  // of waiting for the next poll.
  useWeatherStream((evt) => {
    if (isToday && evt.city === cityDecoded.toLowerCase() && evt.local_date === params.date) {
      mutate();
    }
  });

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
              unit={data.unit}
              winningLow={data.winningLow}
              winningHigh={data.winningHigh}
              winningBracket={data.winningBracket}
            />
          </section>
          <section>
            <h2 className="text-sm text-subtext mb-2">Market price over the day</h2>
            <PriceChart ticks={data.ticks} />
          </section>
        </div>
      )}
    </div>
  );
}
