"use client";

import useSWR from "swr";
import TempChart from "@/components/TempChart";
import PriceChart from "@/components/PriceChart";
import type { EnrichedTick } from "@/lib/weather-transform";
import { useWeatherStream } from "@/lib/useWeatherStream";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface LiveCity {
  city: string;
  region: string;
  cadenceMinutes: number;
  localDate: string;
  localTime: string;
  isLive: boolean;
}

function LiveCityPanel({ city, localDate, localTime }: LiveCity) {
  const key = `/api/day/${encodeURIComponent(city)}/${localDate}`;
  const { data, mutate } = useSWR(key, fetcher, {
    // Backstop only — new ticks trigger an immediate refetch via the SSE
    // stream below, this just covers a dropped event.
    refreshInterval: 5 * 60_000,
  });

  useWeatherStream((evt) => {
    if (evt.city === city.toLowerCase() && evt.local_date === localDate) {
      mutate();
    }
  });

  return (
    <div className="card">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="capitalize font-medium">{city}</h2>
        <span className="text-subtext text-xs">local {localTime}</span>
      </div>
      {!data && <div className="text-subtext text-sm">Loading…</div>}
      {data?.ticks?.length > 0 && (
        <div className="space-y-4">
          <TempChart
            ticks={data.ticks as EnrichedTick[]}
            unit={data.unit}
            winningLow={data.winningLow}
            winningHigh={data.winningHigh}
            winningBracket={data.winningBracket}
          />
          <PriceChart ticks={data.ticks as EnrichedTick[]} />
        </div>
      )}
      {data?.ticks?.length === 0 && (
        <div className="text-subtext text-sm">No ticks yet today.</div>
      )}
    </div>
  );
}

export default function LivePage() {
  const { data, isLoading } = useSWR<{ generatedAt: string; cities: LiveCity[] }>(
    "/api/live",
    fetcher,
    { refreshInterval: 60_000 }
  );

  const liveCities = data?.cities.filter((c) => c.isLive) ?? [];

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Live now</h1>
      <p className="text-subtext text-sm mb-6">
        Cities currently inside their 8am–6pm local capture window. Refreshes every 60s.
      </p>

      {isLoading && <div className="text-subtext">Checking cities…</div>}
      {!isLoading && liveCities.length === 0 && (
        <div className="text-subtext">No cities currently in their capture window.</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {liveCities.map((c) => (
          <LiveCityPanel key={c.city} {...c} />
        ))}
      </div>
    </div>
  );
}
