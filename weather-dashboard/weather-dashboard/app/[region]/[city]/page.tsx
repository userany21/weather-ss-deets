"use client";

import Link from "next/link";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function CityPage({ params }: { params: { region: string; city: string } }) {
  const cityDecoded = decodeURIComponent(params.city);
  const { data, isLoading } = useSWR(`/api/dates/${encodeURIComponent(cityDecoded)}`, fetcher);

  return (
    <div>
      <div className="text-subtext text-sm mb-2">
        <Link href="/">Regions</Link> / <Link href={`/${params.region}`} className="capitalize">{params.region}</Link> /{" "}
        <span className="capitalize">{cityDecoded}</span>
      </div>
      <h1 className="text-xl font-semibold mb-4 capitalize">{cityDecoded} — dates</h1>

      {isLoading && <div className="text-subtext">Loading…</div>}
      {data?.dates?.length === 0 && <div className="text-subtext">No ticks recorded for this city yet.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 max-w-3xl">
        {data?.dates?.map((date: string) => (
          <Link
            key={date}
            href={`/${params.region}/${encodeURIComponent(cityDecoded)}/${date}`}
            className="card text-center"
          >
            {date}
          </Link>
        ))}
      </div>
    </div>
  );
}
