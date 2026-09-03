import Link from "next/link";
import { notFound } from "next/navigation";
import { CityConfig } from "@/lib/cities-config";

async function getCities(region: string): Promise<CityConfig[]> {
  // Fetch from our own API route which now derives city list from Mongo.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
  const res = await fetch(`${baseUrl}/api/cities/${encodeURIComponent(region)}`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.cities ?? [];
}

export default async function RegionPage({ params }: { params: { region: string } }) {
  const cities = await getCities(params.region);
  if (cities.length === 0) notFound();

  return (
    <div>
      <div className="text-subtext text-sm mb-2">
        <Link href="/">Regions</Link> / <span className="capitalize">{params.region}</span>
      </div>
      <h1 className="text-xl font-semibold mb-4 capitalize">{params.region} cities</h1>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-3xl">
        {cities.map((c) => (
          <Link key={c.city} href={`/${params.region}/${encodeURIComponent(c.city)}`} className="card">
            <div className="capitalize">{c.city}</div>
            <div className="text-subtext text-xs">{c.timezone}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
